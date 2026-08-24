/**
 * Quiet-launch injector for the e2e Obsidian instance.
 *
 * Loaded into Electron's MAIN process via `--require` before Obsidian's app
 * code runs. The test window must never steal focus or cover the user's
 * screen: every BrowserWindow is shown without activation, focus() is
 * neutered, and the window is parked offscreen. Background throttling is
 * disabled so the offscreen window keeps rendering (Playwright drives input
 * via CDP, which needs no OS focus).
 *
 * Bypass: WADJET_E2E_VISIBLE=1 (the launcher skips the --require entirely).
 * Pattern borrowed from Windrose's tests/e2e/quiet-launch.cjs.
 */
const { app } = require("electron");

const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = 0;

app.on("browser-window-created", (_event, win) => {
  const showInactive = win.showInactive.bind(win);
  win.show = () => showInactive();
  win.focus = () => {};

  const park = () => {
    try {
      win.setPosition(OFFSCREEN_X, OFFSCREEN_Y);
    } catch {
      /* window may already be destroyed */
    }
  };
  park();
  win.once("ready-to-show", park);

  const unthrottle = () => {
    try {
      win.webContents.setBackgroundThrottling(false);
    } catch {
      /* ignore */
    }
  };
  unthrottle();
  win.webContents.on("did-finish-load", unthrottle);
});
