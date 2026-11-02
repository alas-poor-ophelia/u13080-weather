/**
 * The Studio's menus. A window's own Escape closed the window under a menu it
 * had opened, and Obsidian's own Escape can take a second press (seen on 1.15.0,
 * wadjet-5xo). So the Studio remembers the menu it has open, and one Escape
 * anywhere in the Studio closes that menu and nothing else (view.ts).
 */
import { Menu } from "obsidian";

let open: Menu | null = null;
/** When the last menu closed, on the epoch clock: Obsidian's Escape reaches the menu first when it works, and the same keypress then reaches the Studio. */
let closedAt = -Infinity;

/** A menu the Studio's Escape can close. */
export function studioMenu(): Menu {
  const menu = new Menu();
  open?.hide();
  open = menu;
  menu.onHide(() => {
    if (open === menu) open = null;
    closedAt = performance.timeOrigin + performance.now();
  });
  return menu;
}

/** Close the open menu; whether this keypress was for a menu (one was open, or it closed one on its way here). */
export function closeStudioMenu(ev: KeyboardEvent): boolean {
  if (open) {
    open.hide();
    return true;
  }
  const clock = ev.view?.performance ?? performance;
  return closedAt >= clock.timeOrigin + ev.timeStamp;
}
