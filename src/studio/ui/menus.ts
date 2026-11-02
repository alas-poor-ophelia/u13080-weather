/**
 * The Studio's menus. A window's own Escape closed the window under a menu it
 * had opened, and Obsidian's own Escape can take a second press (seen on 1.15.0,
 * wadjet-5xo). So the Studio remembers the
 * menu it has open, and one Escape anywhere in the Studio closes that menu and
 * nothing else (view.ts).
 */
import { Menu } from "obsidian";

let open: Menu | null = null;

/** A menu the Studio's Escape can close. */
export function studioMenu(): Menu {
  const menu = new Menu();
  open?.hide();
  open = menu;
  menu.onHide(() => {
    if (open === menu) open = null;
  });
  return menu;
}

/** Close the open menu, if any; whether there was one. */
export function closeStudioMenu(): boolean {
  if (!open) return false;
  open.hide();
  open = null;
  return true;
}
