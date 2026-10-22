/**
 * The header's menu on phones: the WAI-ARIA disclosure pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
 *
 * The toggle's `aria-expanded` is the only state; Header.astro's CSS shows
 * the link list from it. Escape closes the menu and returns focus to the
 * toggle, and a click outside closes it. From 40rem up the toggle is hidden
 * and the links sit inline, whatever the state. Without JavaScript there is
 * no `js` class, so the toggle stays hidden and the links show on their own
 * row.
 */

export function initMenu(toggle: HTMLElement): void {
  const doc = toggle.ownerDocument;
  const panel = doc.getElementById(toggle.getAttribute("aria-controls") ?? "");
  if (!panel) return;

  const isOpen = (): boolean => toggle.getAttribute("aria-expanded") === "true";
  const setOpen = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", () => setOpen(!isOpen()));

  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    setOpen(false);
    toggle.focus();
  });

  doc.addEventListener("click", (event) => {
    const target = event.target;
    if (!isOpen() || !(target instanceof Node)) return;
    if (toggle.contains(target) || panel.contains(target)) return;
    setOpen(false);
  });
}
