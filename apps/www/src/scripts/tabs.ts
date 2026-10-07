/**
 * The demo's tab switcher: the WAI-ARIA tabs pattern with automatic
 * activation (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).
 *
 * The page is rendered with the first tab selected and the other panels
 * `hidden`, so nothing moves when this runs. Arrow keys move between tabs
 * (Home and End jump to the ends), only the selected tab is in the tab
 * order, and Tab from it goes into the panel. Without JavaScript a
 * `<noscript>` style in Demo.astro shows every panel and hides the tab list.
 */

export function selectTab(tablist: Element, tab: HTMLElement): void {
  const tabs = Array.from(
    tablist.querySelectorAll<HTMLElement>('[role="tab"]'),
  );
  const doc = tablist.ownerDocument;
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    const panelId = other.getAttribute("aria-controls");
    const panel = panelId ? doc.getElementById(panelId) : null;
    if (panel) panel.hidden = !selected;
  }
}

export function initTabs(tablist: Element): void {
  const tabs = Array.from(
    tablist.querySelectorAll<HTMLElement>('[role="tab"]'),
  );
  if (tabs.length === 0) return;

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tablist, tab));
  }

  tablist.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    const current = tabs.indexOf(e.target as HTMLElement);
    if (current < 0) return;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = tabs[next];
    if (target) {
      selectTab(tablist, target);
      target.focus();
    }
  });
}
