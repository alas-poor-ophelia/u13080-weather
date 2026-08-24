/**
 * Smoke walk against a real Obsidian (1.13+: settings live in
 * their own window, modals open inside it).
 *
 * One Obsidian instance is launched for the whole file; the tests run in
 * order and share state (a zone added in one step is edited in the next).
 * A second launch at the end checks persistence.
 *
 *   bun run test:e2e                               # fixture vault (test/e2e/vault)
 *   WADJET_E2E_VAULT="C:\path\to\vault" bun run test:e2e
 *   WADJET_E2E_VISIBLE=1 ...                       # watch it happen
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installPlugin, launchObsidian, PLUGIN_DIR, VAULT, withApp, type Obsidian } from "./obsidian";

const NOTE = "Wadjet Smoke.md";
const DATA_JSON = path.join(PLUGIN_DIR, "data.json");

let ob: Obsidian;
/** The Settings window (Obsidian 1.13 opens settings in its own window). */
let sw: Page;
const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(`  · ${s}`);
};

async function enableWadjet(): Promise<{ ok: boolean; readyEvent: boolean; ready: boolean; version: string; generatorVersion: string }> {
  await withApp(ob.page, async (app) => {
    // If the vault already has Wadjet enabled (community-plugins.json), unload it first so the
    // load → ready → event sequence below is observed from the start, not joined mid-way.
    if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    (window as unknown as { __wadjetReady?: boolean }).__wadjetReady = false;
    app.workspace.on("wadjet:ready", () => ((window as unknown as { __wadjetReady?: boolean }).__wadjetReady = true));
  });
  const ok = await withApp(ob.page, (app) => app.plugins.enablePlugin("wadjet") as Promise<boolean>);
  await ob.page.waitForFunction(() => (window as unknown as { Wadjet?: { ready?: boolean } }).Wadjet?.ready === true, null, { timeout: 15_000 });
  return withApp(ob.page, () => {
    const w = window as unknown as { Wadjet: { ready: boolean; version: string; generatorVersion: string }; __wadjetReady: boolean };
    return { ok: true, readyEvent: w.__wadjetReady, ready: w.Wadjet.ready, version: w.Wadjet.version, generatorVersion: w.Wadjet.generatorVersion };
  }).then((r) => ({ ...r, ok }));
}

/** Open (or re-focus) the Wadjet settings tab and bind `sw` to the settings window. */
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
  if (!sw) throw new Error("settings window did not open");
  await sw.locator(".vertical-tab-content .setting-item-heading .setting-item-name:text-is('World')").waitFor({ state: "visible", timeout: 10_000 });
}

const tab = () => sw.locator(".vertical-tab-content");
const row = (name: string) => tab().locator(`.setting-item:has(> .setting-item-info > .setting-item-name:text-is("${name}"))`);
const modal = () => sw.locator(".modal-container .modal");
const modalRow = (name: string) => modal().locator(`.setting-item:has(.setting-item-name:text-is("${name}"))`);
const listRows = (heading: string) => tab().locator(`.setting-group.mod-list:has(.setting-item-heading .setting-item-name:text-is("${heading}")) .setting-items > .setting-item:not(.mod-empty-state)`);
const addButton = (label: string) => tab().locator(`.extra-setting-button[aria-label="${label}"]`);

const SMOKE_BLOCKS = [
  "```wadjet\nzone: greywold-highlands\ndate: today\nstyle: card\n```",
  "```wadjet\nzone: greywold-highlands\nstyle: card\nhour: 14\n```",
  "```wadjet\nzone: greywold-highlands\nstyle: line\n```",
  "```wadjet\nzone: ashfall-coast\nstyle: prose\n```",
  "```wadjet\nzone: greywold-highlands\nstyle: table\nrange: 5\n```",
  "```wadjet\nzone: nope\n```",
  "```wadjet\nstyle: card\n```",
];
const SMOKE_MD = SMOKE_BLOCKS.join("\n\n");
/** Scratch notes: the combined note plus one note per block. */
const blockNote = (i: number) => `Wadjet Smoke ${i + 1}.md`;
const SCRATCH_NOTES = [NOTE, ...SMOKE_BLOCKS.map((_, i) => blockNote(i))];

interface Block {
  cls: string;
  text: string;
  rows: number;
  overriddenRows: number;
}

/** Create-or-update a note and open it in reading view in the active leaf. */
async function openInReadingView(path: string, md: string): Promise<void> {
  await withApp(
    ob.page,
    async (app, a) => {
      let f = app.vault.getAbstractFileByPath(a.path);
      if (f) await app.vault.modify(f, a.md);
      else f = await app.vault.create(a.path, a.md);
      await app.workspace.getLeaf(false).openFile(f, { state: { mode: "preview" } });
    },
    { path, md },
  );
}

/**
 * The first rendered ```wadjet block in the active reading view. Obsidian's
 * reading view virtualises long notes (renders lazily AND detaches sections
 * that scroll away), so multi-block counts there depend on scroll position;
 * the walk therefore renders one block per note and reads each alone.
 */
async function readFirstBlock(): Promise<Block> {
  const el = ob.page.locator(".workspace-leaf.mod-active .markdown-preview-view").locator(".wadjet-card, .wadjet-line, .wadjet-prose, .wadjet-table, .wadjet-error").first();
  await el.waitFor({ state: "attached", timeout: 10_000 });
  return el.evaluate((b) => ({
    cls: b.classList[0] ?? "",
    text: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
    rows: b.querySelectorAll("tbody tr").length,
    overriddenRows: b.querySelectorAll("tbody tr.wadjet-overridden").length,
  }));
}

async function renderBlocks(): Promise<Block[]> {
  const out: Block[] = [];
  for (let i = 0; i < SMOKE_BLOCKS.length; i++) {
    await openInReadingView(blockNote(i), SMOKE_BLOCKS[i]!);
    out.push(await readFirstBlock());
  }
  return out;
}

/** Text of every visible Notice, in whichever window it appeared. */
async function allNotices(): Promise<string[]> {
  const out: string[] = [];
  for (const w of ob.app.windows()) if (!w.isClosed()) out.push(...(await w.locator(".notice").allTextContents()));
  return out;
}

beforeAll(async () => {
  installPlugin();
  // Start from a world with no data.json so the seed is freshly generated.
  rmSync(DATA_JSON, { force: true });
  for (const n of SCRATCH_NOTES) rmSync(path.join(VAULT, n), { force: true });
  ob = await launchObsidian();
  note(`vault: ${VAULT}`);
});

afterAll(async () => {
  if (ob) await ob.close();
  console.log("\nSMOKE LOG\n" + log.map((l) => `  - ${l}`).join("\n"));
});

describe("smoke walk", () => {
  test("plugin loads: window.Wadjet.ready is true and wadjet:ready fired", async () => {
    const r = await enableWadjet();
    note(`loaded ${r.version}, generator ${r.generatorVersion}; ready=${r.ready} readyEvent=${r.readyEvent}`);
    expect(r.ok).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.readyEvent).toBe(true);
    expect(existsSync(DATA_JSON)).toBe(true);
    const seed = (JSON.parse(readFileSync(DATA_JSON, "utf8")) as { worldSeed: string }).worldSeed;
    expect(seed).toMatch(/^[0-9a-f]{16}$/);
    note(`fresh seed persisted: ${seed}`);
  });

  test("settings tab renders (declarative 1.13 API, own window)", async () => {
    await openWadjetSettings();
    const headings = await tab().locator(".setting-item-heading .setting-item-name").allTextContents();
    expect(headings).toEqual(["World", "Calendar", "Zones", "Pinned days"]);
    expect(await row("World seed").locator("input").inputValue()).toMatch(/^[0-9a-f]{16}$/);
    expect(await row("Generator").isVisible()).toBe(false); // only shown on a generator mismatch
    expect(await tab().locator(".setting-item.mod-empty-state").count()).toBe(2);
    expect(await addButton("Add zone").count()).toBe(1);
    expect(await addButton("Pin a day").count()).toBe(1);
    const title = await sw.locator(".modal-title").textContent();
    note(`settings window title "${title?.trim()}"; sections: ${headings.join(", ")}; two empty states`);
    expect(title).toContain("U+13080 Weather");
  });

  test("add a zone from a preset (modal)", async () => {
    await openWadjetSettings();
    await addButton("Add zone").click();
    await modalRow("Name").locator("input").fill("Greywold Highlands");
    const presetLabels = await modalRow("Climate").locator("select:not(.is-measuring) option").allTextContents();
    const presetCount = presetLabels.length;
    expect(presetCount).toBeGreaterThan(10);
    // station names with multi-word countries parse cleanly (was "States    Fremont Pass")
    expect(presetLabels.some((l) => l.includes("Fremont Pass"))).toBe(true);
    expect(presetLabels.some((l) => /\S {2,}\S/.test(l))).toBe(false);
    await modal().locator("button:has-text('Add')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await row("Greywold Highlands").waitFor({ state: "visible", timeout: 5_000 });
    const n = await allNotices();
    note(`preset zone notice: ${n.join(" | ")} (${presetCount} climates offered)`);
    expect(n.some((t) => t.includes("Copied from preset"))).toBe(true);
    const zones = await withApp(ob.page, () => (window as unknown as { Wadjet: { listZones(): unknown[] } }).Wadjet.listZones());
    expect(zones).toEqual([{ id: "greywold-highlands", name: "Greywold Highlands" }]);
    const desc = await row("Greywold Highlands").locator(".setting-item-description").textContent();
    note(`zone row: "${desc}"`);
    // id · Köppen code + words · provenance
    expect(desc).toMatch(/^greywold-highlands · [A-E][A-Za-z]{0,2} [a-z][^·]* · from /);
  });

  test("add a zone by geography (modal) and read the provenance notice", async () => {
    await openWadjetSettings();
    await addButton("Add zone").click();
    await modalRow("Name").locator("input").fill("Ashfall Coast");
    await modalRow("Choose by geography").locator(".checkbox-container").click();
    await modalRow("Latitude").locator("input").fill("62");
    await modalRow("Altitude").locator("input").fill("30");
    await modalRow("Terrain").locator("select:not(.is-measuring)").selectOption("windward");
    expect(await modalRow("Continentality").isVisible()).toBe(false); // hidden until "Adjust the seasonal swing" is on
    await modal().locator("button:has-text('Add')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await row("Ashfall Coast").waitFor({ state: "visible", timeout: 5_000 });
    const n = (await allNotices()).filter((t) => !t.includes("Copied from preset"));
    note(`geography notice: ${n.join(" | ")}`);
    expect(n.some((t) => t.startsWith("Closest match:"))).toBe(true);
    expect(n.join(" ")).not.toContain("continentality");
    const z = await withApp(ob.page, (app) => {
      const zone = app.plugins.plugins.wadjet.settings.zones.find((x: { id: string }) => x.id === "ashfall-coast");
      return { geography: zone.geography, preset: zone.preset };
    });
    note(`geography zone: preset ${z.preset.id} (matched=${z.preset.matched}), geography ${JSON.stringify(z.geography)}`);
    expect(z.preset.matched).toBe("auto");
    expect(z.geography).toEqual({ latitude: 62, altitude: 30, orographic: "windward" });
  });

  test("zone Edit modal rejects invalid input and saves a valid edit", async () => {
    await openWadjetSettings();
    await row("Greywold Highlands").locator("button:has-text('Edit')").click();
    const ta = modal().locator("textarea.wadjet-json");
    await ta.waitFor({ state: "visible", timeout: 5_000 });
    const original = JSON.parse(await ta.inputValue()) as { name: string; climate: unknown };

    await ta.fill("{ this is not json");
    await modal().locator("button:has-text('Save')").click();
    let err = await modal().locator(".wadjet-error").textContent();
    note(`invalid JSON → "${err?.slice(0, 80)}"`);
    expect(err?.length ?? 0).toBeGreaterThan(0);
    expect(await modal().count()).toBe(1);

    await ta.fill(JSON.stringify({ ...original, climate: {} }));
    await modal().locator("button:has-text('Save')").click();
    err = await modal().locator(".wadjet-error").textContent();
    note(`invalid profile → "${err?.slice(0, 120)}"`);
    expect(err?.length ?? 0).toBeGreaterThan(0);
    expect(await modal().count()).toBe(1);

    await ta.fill(JSON.stringify({ ...original, name: "Greywold Highlands (edited)" }, null, 2));
    await modal().locator("button:has-text('Save')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await row("Greywold Highlands (edited)").waitFor({ state: "visible", timeout: 5_000 });
    const onDisk = JSON.parse(readFileSync(DATA_JSON, "utf8")) as { zones: Array<{ id: string; name: string }> };
    expect(onDisk.zones.find((z) => z.id === "greywold-highlands")?.name).toBe("Greywold Highlands (edited)");
    note("valid edit saved to data.json; zone id preserved");

    // the modifier grammar card: one click adds an example to the zone's modifiers, and it saves
    await row("Greywold Highlands (edited)").locator("button:has-text('Edit')").click();
    await ta.waitFor({ state: "visible", timeout: 5_000 });
    const grammar = modal().locator("details.wadjet-grammar");
    expect(await grammar.count()).toBe(1);
    await grammar.locator("summary").click();
    const examples = await grammar.locator(".wadjet-example .setting-item-name").allTextContents();
    note(`grammar card examples: ${examples.join(" | ")}`);
    expect(examples.length).toBe(2);
    await grammar.locator(".wadjet-example button:has-text('Add to this zone')").nth(1).click(); // ashfall spells
    expect(await ta.inputValue()).toContain('"id": "ashfall"');
    await modal().locator("button:has-text('Save')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    const mods = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.zones.find((z: { id: string }) => z.id === "greywold-highlands").modifiers as Array<{ id: string }>);
    expect(mods.map((m) => m.id)).toEqual(["ashfall"]);
    note("ashfall example added from the grammar card and saved; later steps generate with it");
  });

  test("codeblock renders card / line / prose / table, hour: gives a now-temperature, errors are visible", async () => {
    const blocks = await renderBlocks();
    expect(blocks.map((b) => b.cls)).toEqual(["wadjet-card", "wadjet-card", "wadjet-line", "wadjet-prose", "wadjet-table", "wadjet-error", "wadjet-card"]);
    const by = (cls: string) => blocks.filter((b) => b.cls === cls);
    const counts = { card: by("wadjet-card").length, line: by("wadjet-line").length, prose: by("wadjet-prose").length, table: by("wadjet-table").length, tableRows: by("wadjet-table")[0]?.rows ?? 0, error: by("wadjet-error").length };
    note(`codeblock counts: ${JSON.stringify(counts)}`);
    note(`error blocks: ${JSON.stringify(by("wadjet-error").map((b) => b.text))}`);
    expect(counts).toEqual({ card: 3, line: 1, prose: 1, table: 1, tableRows: 5, error: 1 });
    const cards = by("wadjet-card").map((b) => b.text);
    note(`card 1: ${cards[0]?.slice(0, 160)}`);
    note(`card 2 (hour 14): ${cards[1]?.slice(0, 160)}`);
    expect(cards[0]).not.toContain("(now ");
    expect(cards[1]).toContain("(now ");
    expect(by("wadjet-error")[0]?.text).toContain('Unknown zone "nope"');
    note(`line: ${by("wadjet-line")[0]?.text}`);
    note(`prose: ${by("wadjet-prose")[0]?.text.slice(0, 160)}`);
    // the combined note renders too (first card visible in the real reading view)
    await openInReadingView(NOTE, SMOKE_MD);
    const first = ob.page.locator(".workspace-leaf.mod-active .markdown-preview-view .wadjet-card").first();
    await first.waitFor({ state: "visible", timeout: 10_000 });
    note(`combined note: first card visible, "${(await first.locator(".wadjet-summary").textContent())?.slice(0, 80)}"`);
  });

  test("commands: next-day, pin-today, refresh, insert-today, insert-codeblock", async () => {
    const before = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.currentDayOrdinal as number);
    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:next-day"));
    const after = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.currentDayOrdinal as number);
    expect(after).toBe(before + 1);
    note(`next-day: ${before} → ${after}; notices: ${(await allNotices()).filter((t) => t.startsWith("Year")).join(" | ")}`);

    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:pin-today"));
    await ob.page.waitForTimeout(300);
    const overrides = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.overrides as Array<{ zoneId: string; dayOrdinal: number }>);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ zoneId: "greywold-highlands", dayOrdinal: after });
    note(`pin-today: override ${JSON.stringify(overrides[0])}`);

    // refresh re-renders the active note: the "today" card is now pinned
    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:refresh"));
    const view = ob.page.locator(".workspace-leaf.mod-active .markdown-preview-view");
    await view.locator(".wadjet-card .wadjet-note").first().waitFor({ state: "visible", timeout: 10_000 });
    const pinnedNote = await view.locator(".wadjet-card .wadjet-note").first().textContent();
    note(`refresh: pinned card shows "${pinnedNote}"`);
    await openInReadingView(blockNote(4), SMOKE_BLOCKS[4]!);
    const table = await readFirstBlock();
    expect(table.cls).toBe("wadjet-table");
    expect(table.overriddenRows).toBe(1);

    // editor commands need source mode (back on the combined note)
    await openInReadingView(NOTE, SMOKE_MD);
    await withApp(ob.page, async (app) => {
      const leaf = app.workspace.getMostRecentLeaf();
      await leaf.setViewState({ type: "markdown", state: { ...leaf.getViewState().state, mode: "source" } });
      leaf.view.editor.setCursor({ line: 0, ch: 0 });
    });
    await ob.page.waitForTimeout(300);
    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:insert-today"));
    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:insert-codeblock"));
    const text = await withApp(ob.page, (app) => app.workspace.getMostRecentLeaf().view.editor.getValue() as string);
    const firstLine = text.split("\n")[0] ?? "";
    note(`insert-today wrote: "${firstLine.slice(0, 140)}"`);
    expect(firstLine).toMatch(/ — .* °C\.$/);
    expect(firstLine).not.toMatch(/-\d/); // negatives use a real minus sign
    // insert-today ends with a newline, so the codeblock lands on its own line
    expect(text).toContain("°C.\n```wadjet\nzone: greywold-highlands\ndate: today\nstyle: card\n```");
  });

  test("pinned days are listed, editable, deletable and creatable from settings", async () => {
    await openWadjetSettings();
    const pins = listRows("Pinned days");
    await pins.first().waitFor({ state: "visible", timeout: 5_000 });
    expect(await pins.count()).toBe(1);
    const name = await pins.first().locator(".setting-item-name").textContent();
    const desc = await pins.first().locator(".setting-item-description").textContent();
    note(`pin row: "${name}" — "${desc}"`);
    expect(name).toMatch(/^Greywold Highlands \(edited\) · Year 1, day 2/);
    expect(desc).toMatch(/°C/);

    // edit: low above high is rejected inline, then a real edit saves
    await pins.first().locator("button:has-text('Edit')").click();
    await modalRow("Low temperature").locator("input").waitFor({ state: "visible", timeout: 5_000 });
    await modalRow("Low temperature").locator("input").fill("10");
    await modalRow("High temperature").locator("input").fill("3");
    await modal().locator("button:has-text('Save')").click();
    expect(await modal().locator(".setting-item.is-invalid").count()).toBe(1);
    await modalRow("Low temperature").locator("input").fill("-5");
    await modalRow("Precipitation").locator("select:not(.is-measuring)").selectOption("snow");
    await modalRow("Amount").locator("input").fill("4");
    await modalRow("Note").locator("input").fill("blizzard");
    await modal().locator("button:has-text('Save')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await ob.page.waitForTimeout(300);
    const edited = await pins.first().locator(".setting-item-description").textContent();
    note(`edited pin row: "${edited}"`);
    // wind comes from the generated weather the pin started from, so it may be calm or a speed
    expect(edited).toMatch(/^−5 to 3 °C · snow 4 mm · (calm|\d+ km\/h) · blizzard$/);
    const report = await withApp(ob.page, (app) => {
      const s = app.plugins.plugins.wadjet.settings;
      const r = (window as unknown as { Wadjet: { getReport(z: string, t: { dayOrdinal: number }): { temperature: { low: number; high: number }; precipitation: { type: string; amountMm: number }; overridden: boolean } } }).Wadjet.getReport("greywold-highlands", { dayOrdinal: s.currentDayOrdinal });
      return { low: r.temperature.low, high: r.temperature.high, type: r.precipitation.type, mm: r.precipitation.amountMm, overridden: r.overridden };
    });
    note(`report after edit: ${JSON.stringify(report)}`);
    expect(report).toEqual({ low: -5, high: 3, type: "snow", mm: 4, overridden: true });

    // imperial: the list and the editor speak °F / in / mph, storage stays metric
    await row("Units").locator("select:not(.is-measuring)").selectOption("imperial");
    await ob.page.waitForTimeout(500);
    const imperial = await pins.first().locator(".setting-item-description").textContent();
    note(`pin row in imperial: "${imperial}"`);
    expect(imperial).toMatch(/^23 to 37\.4 °F · snow 0\.16 in · (calm|\d+ mph) · blizzard$/);
    await pins.first().locator("button:has-text('Edit')").click();
    await modalRow("Low temperature").locator("input").waitFor({ state: "visible", timeout: 5_000 });
    expect(await modalRow("Low temperature").locator(".setting-item-description").textContent()).toBe("°F");
    expect(await modalRow("Low temperature").locator("input").inputValue()).toBe("23");
    await modalRow("High temperature").locator("input").fill("50");
    await modal().locator("button:has-text('Save')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await ob.page.waitForTimeout(300);
    const storedHigh = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.overrides[0].patch.temperature.high as number);
    expect(storedHigh).toBe(10); // 50 °F
    expect(await pins.first().locator(".setting-item-description").textContent()).toMatch(/^23 to 50 °F/);
    await row("Units").locator("select:not(.is-measuring)").selectOption("metric");
    await ob.page.waitForTimeout(500);
    expect(await pins.first().locator(".setting-item-description").textContent()).toMatch(/^−5 to 10 °C · snow 4 mm/);
    note("imperial round-trip: 50 °F stored as 10 °C; metric summary restored");

    // delete via the list's own affordance
    await pins.first().locator('.extra-setting-button[aria-label="Delete"]').click();
    await ob.page.waitForTimeout(500);
    expect(await listRows("Pinned days").count()).toBe(0);
    expect(await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.overrides.length as number)).toBe(0);
    note("pin deleted from settings");

    // create a new pin from settings (prefilled from generated weather)
    await addButton("Pin a day").click();
    await modalRow("Day").locator("input").waitFor({ state: "visible", timeout: 5_000 });
    expect(await modalRow("Day").locator("input").inputValue()).toBe("1");
    // the prefilled fields follow the chosen zone/day
    const generated = await withApp(ob.page, () => {
      const W = (window as unknown as { Wadjet: { getReport(z: string, t: { dayOrdinal: number }): { temperature: { low: number } } } }).Wadjet;
      return { greywold: W.getReport("greywold-highlands", { dayOrdinal: 1 }).temperature.low, ashfall: W.getReport("ashfall-coast", { dayOrdinal: 1 }).temperature.low };
    });
    expect(await modalRow("Low temperature").locator("input").inputValue()).toBe(String(generated.greywold));
    await modalRow("Zone").locator("select:not(.is-measuring)").selectOption("ashfall-coast");
    expect(await modalRow("Low temperature").locator("input").inputValue()).toBe(String(generated.ashfall));
    note(`new-pin prefill follows the zone: greywold low ${generated.greywold} → ashfall low ${generated.ashfall}`);
    await modalRow("Low temperature").locator("input").fill("1");
    await modalRow("High temperature").locator("input").fill("9");
    await modal().locator("button:has-text('Pin')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    await listRows("Pinned days").first().waitFor({ state: "visible", timeout: 5_000 });
    const created = await listRows("Pinned days").first().locator(".setting-item-name").textContent();
    note(`created pin row: "${created}"`);
    expect(created).toMatch(/^Ashfall Coast · Year 1, day 2/);
    expect(await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.overrides.length as number)).toBe(1);

    // pinning the same zone/day again is refused inline rather than silently replacing the pin
    await addButton("Pin a day").click();
    await modalRow("Zone").locator("select:not(.is-measuring)").selectOption("ashfall-coast");
    await modal().locator("button:has-text('Pin')").click();
    expect(await modalRow("Day").locator(".setting-item-description, .setting-error").count()).toBeGreaterThan(0);
    expect(await modal().locator(".setting-item.is-invalid").count()).toBe(1);
    await sw.keyboard.press("Escape");
    await modal().waitFor({ state: "detached", timeout: 5_000 });
    expect(await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.overrides.length as number)).toBe(1);
    note("duplicate pin refused inline");
  });

  test("no uncaught errors in the vault window", () => {
    const mine = ob.errors.filter((e) => /wadjet/i.test(e));
    if (ob.errors.length) note(`window errors (all): ${ob.errors.length}; wadjet-related: ${mine.length}`);
    for (const e of mine) note(`  ! ${e.slice(0, 200)}`);
    // Histogram of everything else, so a Wadjet-caused error that never says "wadjet" is still visible.
    const hist = new Map<string, number>();
    for (const e of ob.errors) hist.set(e.slice(0, 90), (hist.get(e.slice(0, 90)) ?? 0) + 1);
    for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) note(`  other ×${v}: ${k}`);
    expect(mine).toEqual([]);
  });

  test("seed, zones and pins survive an Obsidian restart", async () => {
    const before = JSON.parse(readFileSync(DATA_JSON, "utf8")) as { worldSeed: string; zones: unknown[]; overrides: unknown[]; currentDayOrdinal: number };
    await withApp(
      ob.page,
      async (app, paths) => {
        for (const p of paths) {
          const f = app.vault.getAbstractFileByPath(p);
          if (f) await app.vault.delete(f);
        }
      },
      SCRATCH_NOTES,
    );
    await ob.close();
    ob = await launchObsidian();
    const r = await enableWadjet();
    expect(r.ready).toBe(true);
    const live = await withApp(ob.page, (app) => {
      const s = app.plugins.plugins.wadjet.settings;
      return { worldSeed: s.worldSeed, zones: s.zones.length, overrides: s.overrides.length, currentDayOrdinal: s.currentDayOrdinal };
    });
    note(`after restart: seed ${live.worldSeed}, ${live.zones} zones, ${live.overrides} pin(s), day ${live.currentDayOrdinal}`);
    expect(live).toEqual({ worldSeed: before.worldSeed, zones: before.zones.length, overrides: before.overrides.length, currentDayOrdinal: before.currentDayOrdinal });
    expect(live.zones).toBe(2);
    expect(live.overrides).toBe(1);
  });
});
